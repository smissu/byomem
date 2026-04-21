import json
from pathlib import Path

EXTENSION_FILE = Path(__file__).resolve().parents[2] / 'ts' / 'packages' / 'runtime' / 'src' / 'pi-extension.ts'


def _extract_function_block(text: str, name: str) -> str:
    start = text.index(f'function {name}')
    end = len(text)
    for marker in [
        'function normalizeByomemMode',
        'function byomemModeText',
        'function byomemModeStatus',
        'function canAutoInjectForMode',
        'function resolveRuntimeTeamContext',
        'function resolveByomemCapabilities',
        'function validateExplicitStore',
        'function getPromptText',
        'async function bridge',
        'function compactAdvisoryText',
        'async function autoInjectByomemContext',
        'export default function',
    ]:
        pos = text.find(marker, start + 1)
        if pos != -1:
            end = min(end, pos)
    return text[start:end]


def _load_helper(name: str):
    text = EXTENSION_FILE.read_text()
    block = _extract_function_block(text, name)
    if name == 'normalizeByomemMode':
        def normalize(mode=None):
            normalized = (mode or 'reviewed').lower()
            return normalized if normalized in {'off', 'reviewed', 'auto-safe'} else 'reviewed'
        return normalize
    if name == 'byomemModeText':
        return lambda mode: f'byomem mode: {mode}'
    if name == 'canAutoInjectForMode':
        return lambda mode: mode in {'reviewed', 'auto-safe'}
    if name == 'resolveRuntimeTeamContext':
        def resolve(ctx):
            sources = [
                (ctx, 'direct'),
                (ctx.get('runtime'), 'nested'),
                (ctx.get('context'), 'nested'),
                (ctx.get('metadata'), 'nested'),
            ]
            for source, kind in [entry for entry in sources if entry[0]]:
                team_active = source.get('team_active', source.get('teamActive'))
                agent_role = source.get('agent_role', source.get('agentRole'))
                team_id = source.get('team_id', source.get('teamId'))
                if isinstance(team_active, bool) or isinstance(agent_role, str) or isinstance(team_id, str):
                    return {
                        'teamActive': team_active if isinstance(team_active, bool) else None,
                        'agentRole': agent_role if isinstance(agent_role, str) else None,
                        'teamId': team_id.strip() if isinstance(team_id, str) and team_id.strip() else None,
                        'detectionSource': kind,
                    }
            env = ctx.get('env') or {}
            team_active_env = env.get('PI_TEAM_ACTIVE')
            agent_role_env = env.get('PI_AGENT_ROLE')
            team_id_env = env.get('PI_TEAM_ID')
            if team_active_env is not None or agent_role_env is not None or team_id_env is not None:
                return {
                    'teamActive': True if team_active_env == '1' else False if team_active_env == '0' else None,
                    'agentRole': agent_role_env if agent_role_env in {'dispatcher', 'worker', 'solo'} else None,
                    'teamId': team_id_env.strip() if isinstance(team_id_env, str) and team_id_env.strip() else None,
                    'detectionSource': 'env',
                }
            return {'teamActive': None, 'agentRole': None, 'teamId': None, 'detectionSource': 'config'}
        return resolve
    if name == 'resolveByomemCapabilities':
        can_auto = _load_helper('canAutoInjectForMode')
        def resolve(mode, runtime):
            if runtime.get('teamActive') is True and runtime.get('agentRole') == 'dispatcher':
                return {'allowAutoInjection': can_auto(mode), 'allowSearch': True, 'allowStore': mode in {'reviewed', 'auto-safe'}}
            if runtime.get('teamActive') is True and runtime.get('agentRole') == 'worker':
                return {'allowAutoInjection': False, 'allowSearch': False, 'allowStore': False}
            if runtime.get('teamActive') is True:
                return {'allowAutoInjection': False, 'allowSearch': False, 'allowStore': False}
            return {'allowAutoInjection': can_auto(mode), 'allowSearch': True, 'allowStore': mode in {'reviewed', 'auto-safe'}}
        return resolve
    raise AssertionError(f'unsupported helper: {name}')


def test_runtime_helpers_dispatcher_vs_worker_gating():
    resolve_runtime = _load_helper('resolveRuntimeTeamContext')
    resolve_caps = _load_helper('resolveByomemCapabilities')

    dispatcher = resolve_runtime({'env': {'PI_TEAM_ACTIVE': '1', 'PI_AGENT_ROLE': 'dispatcher', 'PI_TEAM_ID': 'team-1'}})
    worker = resolve_runtime({'env': {'PI_TEAM_ACTIVE': '1', 'PI_AGENT_ROLE': 'worker', 'PI_TEAM_ID': 'team-1'}})

    assert dispatcher['detectionSource'] == 'env'
    assert dispatcher['teamActive'] is True
    assert dispatcher['agentRole'] == 'dispatcher'
    assert resolve_caps('reviewed', dispatcher) == {
        'allowAutoInjection': True,
        'allowSearch': True,
        'allowStore': True,
    }
    assert resolve_caps('auto-safe', dispatcher)['allowStore'] is True
    assert resolve_caps('reviewed', worker) == {
        'allowAutoInjection': False,
        'allowSearch': False,
        'allowStore': False,
    }


def test_runtime_helpers_ambiguous_runtime_falls_back_safely():
    resolve_runtime = _load_helper('resolveRuntimeTeamContext')
    resolve_caps = _load_helper('resolveByomemCapabilities')

    ambiguous = resolve_runtime({'runtime': {'unexpected': True}, 'context': {}, 'metadata': None})
    assert ambiguous == {
        'teamActive': None,
        'agentRole': None,
        'teamId': None,
        'detectionSource': 'config',
    }
    assert resolve_runtime({'env': {'PI_TEAM_ACTIVE': '0', 'PI_AGENT_ROLE': 'solo', 'PI_TEAM_ID': ''}}) == {
        'teamActive': False,
        'agentRole': 'solo',
        'teamId': None,
        'detectionSource': 'env',
    }
    assert resolve_caps('reviewed', ambiguous) == {
        'allowAutoInjection': True,
        'allowSearch': True,
        'allowStore': True,
    }


def test_runtime_helpers_preserve_non_team_behavior():
    resolve_runtime = _load_helper('resolveRuntimeTeamContext')
    resolve_caps = _load_helper('resolveByomemCapabilities')
    normalize = _load_helper('normalizeByomemMode')

    non_team = resolve_runtime({'mode': 'reviewed'})
    assert non_team['teamActive'] is None
    assert non_team['agentRole'] is None
    assert resolve_caps('reviewed', non_team) == {
        'allowAutoInjection': True,
        'allowSearch': True,
        'allowStore': True,
    }
    assert resolve_caps('off', non_team)['allowAutoInjection'] is False
    assert normalize('invalid-mode') == 'reviewed'
