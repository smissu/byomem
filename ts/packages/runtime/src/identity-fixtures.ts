import type { MemoryIdentity, MemoryScope } from './contracts.js';

export const stableIdentityFixtures: Array<{ scope: MemoryScope; identity: MemoryIdentity; stableKey: string }> = [
  {
    scope: 'project',
    identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' },
    stableKey: 'project:byomem:root:project-alpha',
  },
  {
    scope: 'project',
    identity: { namespace: 'byomem', leafName: 'Project   Alpha', parentContext: 'root ' },
    stableKey: 'project:byomem:root:project-alpha',
  },
  {
    scope: 'dir',
    identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'workspace/docs' },
    stableKey: 'dir:byomem:workspace/docs:project-alpha',
  },
  {
    scope: 'agent',
    identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'workspace/docs' },
    stableKey: 'agent:byomem:workspace/docs:project-alpha',
  },
];
