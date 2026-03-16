# Workspace Tabs

## Context

The user has too many containers/sessions/windows and needs a way to organize them into named views. Workspace tabs at the top of the sidebar filter which containers are shown. Each workspace defines a subset of sources, sessions, or windows via hierarchical membership. An "All" tab always shows everything. The tab bar is hidden when no custom workspaces exist, preserving the current UX. Offline bridge containers are shown as "[name] offline" using a stored `displayName`.

### Membership Levels

1. **Source** (container) — adding a source shows everything in it, including new sessions that appear later
2. **Session** — adding a session shows all its windows, including new windows that appear later

---

## Data Model

Store in `data/workspaces.json`. Each workspace stores members as a discriminated union with `displayName` for offline bridge display:

```json
{
  "workspaces": [
    { "id": "all", "name": "All", "members": [], "isDefault": true }
  ],
  "workspaceOrder": ["all"]
}
```

Non-default workspace example:
```json
{ "id": "abc123", "name": "Work", "members": [
  { "type": "source", "sourceId": "bridge:x:local", "displayName": "My Server" },
  { "type": "session", "sourceId": "bridge:x:local", "sessionId": "sess1", "displayName": "dev" }
], "isDefault": false }
```

---

## Backend Changes

### Schemas (`backend/app/schemas/__init__.py`)

```python
from typing import Literal

class WorkspaceMemberSource(CamelModel):
    type: Literal["source"] = "source"
    source_id: str
    display_name: str

class WorkspaceMemberSession(CamelModel):
    type: Literal["session"] = "session"
    source_id: str
    session_id: str
    display_name: str

WorkspaceMember = WorkspaceMemberSource | WorkspaceMemberSession

class WorkspaceResponse(CamelModel):
    id: str
    name: str
    members: list[WorkspaceMember]
    is_default: bool = False

class CreateWorkspaceRequest(CamelModel):
    name: str

class UpdateWorkspaceRequest(CamelModel):
    name: str | None = None
    members: list[WorkspaceMember] | None = None

class WorkspaceListResponse(CamelModel):
    workspaces: list[WorkspaceResponse]
    workspace_order: list[str]

class WorkspaceOrderRequest(CamelModel):
    order: list[str]
```

### Store (`backend/app/store.py`)

Follow `_load_bridges`/`_save_bridges` pattern:
- `_load_workspaces()` / `_save_workspaces()` — read/write `data/workspaces.json`
- `list_workspaces()` — return all workspaces + order
- `create_workspace(name)` — create with generated ID, append to order
- `update_workspace(id, updates)` — update name or members list
- `delete_workspace(id)` — remove (protect default)
- `save_workspace_order(order)` — save tab order ("all" always first)

### Router (`backend/app/api/workspaces.py` — new file)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/workspaces` | List workspaces + order |
| POST | `/api/v1/workspaces` | Create workspace |
| PATCH | `/api/v1/workspaces/{id}` | Update name or members |
| DELETE | `/api/v1/workspaces/{id}` | Delete workspace |
| PUT | `/api/v1/workspaces/ordering` | Save tab order |

**Note:** Use `/ordering` instead of `/order` to avoid FastAPI route conflict with `/{id}`. Register static routes (`/ordering`) before dynamic routes (`/{workspace_id}`) in the router file.

### Registration (`backend/app/main.py`)

Import + `app.include_router(workspaces_router)`

---

## Frontend Changes

### Types (`frontend/src/types/index.ts`)

```typescript
export type WorkspaceMember =
  | { type: "source"; sourceId: string; displayName: string }
  | { type: "session"; sourceId: string; sessionId: string; displayName: string };

export interface Workspace {
  id: string;
  name: string;
  members: WorkspaceMember[];
  isDefault: boolean;
}

export interface WorkspaceListResponse {
  workspaces: Workspace[];
  workspaceOrder: string[];
}
```

### API Client (`frontend/src/api/client.ts` + `httpClient.ts` + `mocks/mockApi.ts`)

Add 5 methods to `ApiClient` interface and implementations:
- `listWorkspaces(): Promise<WorkspaceListResponse>`
- `createWorkspace(name: string): Promise<Workspace>`
- `updateWorkspace(id: string, data: { name?: string; members?: WorkspaceMember[] }): Promise<Workspace>`
- `deleteWorkspace(id: string): Promise<void>`
- `saveWorkspaceOrder(order: string[]): Promise<void>`

### Workspace Filter Utility (`frontend/src/utils/workspaceFilter.ts` — new)

Pure function that determines sidebar visibility given a workspace's members and the live container tree:

```typescript
interface FilterResult {
  /** Set of container IDs to show (source-level or partial) */
  visibleContainerIds: Set<string>;
  /** Map: containerId → Set of sessionIds to show (empty = all) */
  visibleSessions: Map<string, Set<string> | "all">;
  /** Offline source members with no live container match */
  offlineMembers: WorkspaceMemberSource[];
}

export function filterWorkspace(
  members: WorkspaceMember[],
  liveContainers: ContainerInfo[]
): FilterResult;
```

Logic:
- **Source member** → add containerId to `visibleContainerIds`, mark sessions as `"all"`
- **Session member** → add containerId, add sessionId to `visibleSessions` set
- Source members whose `sourceId` matches no live container go into `offlineMembers`

### localStorage (`frontend/src/utils/sidebarState.ts`)

Add `getActiveWorkspaceId()` / `saveActiveWorkspaceId()` for persisting the selected tab.

### WorkspaceTabs Component (`frontend/src/components/WorkspaceTabs.tsx` — new)

Horizontal tab bar rendered between sidebar header and container list:
- Row of tab pills, active one highlighted with blue border-bottom
- "+" button at end to create new workspace (inline text input)
- Pencil icon toggles edit mode: X buttons appear on each tab to delete, double-click tab to rename
- Tab bar hidden when only "All" exists (zero visual change for non-users)
- ~28px height, `text-xs`, matches sidebar dark styling

### Sidebar Integration (`frontend/src/components/Sidebar.tsx`)

- Query workspaces (`queryKey: ['workspaces']`, `staleTime: 30_000`)
- `activeWorkspaceId` state backed by localStorage
- Use `filterWorkspace()` to compute `FilterResult` for the active workspace
- Pass `FilterResult` down to `ContainerNode` components to filter sessions/windows
- For `offlineMembers` → show offline placeholder interleaved in natural container order position:
  - Gray, disabled appearance, "[displayName] offline" text
- Render `<WorkspaceTabs>` between header and scroll area (only when custom workspaces exist)

### Container & Session Filtering (`frontend/src/components/ContainerNode.tsx` + `SessionItem.tsx`)

`ContainerNode`:
- Accept optional `filterResult: FilterResult` prop
- When set, filter rendered sessions using `visibleSessions` map
- If container's sessions entry is `"all"`, show all sessions

`SessionItem`:
- No window-level filtering needed (sessions always show all their windows)

### Source Assignment (`frontend/src/components/ContainerNode.tsx`)

Add "Workspaces" item to the existing three-dot dropdown menu:
- Shows submenu listing all non-default workspaces with checkmarks
- Toggling calls `api.updateWorkspace()` to add/remove the source member
- Receives `workspaces` prop from Sidebar

### Session Assignment (`frontend/src/components/SessionItem.tsx`)

Add a MoreVertical (three-dot) menu to SessionItem (matching the ContainerNode pattern):
- "Workspaces" submenu listing all non-default workspaces with checkmarks
- Toggling calls `api.updateWorkspace()` to add/remove the session member
- A session inherits its workspace membership from a source member (shown as checked + disabled)

---

## Key Behaviors

- Workspace only filters sidebar, not the active terminal
- Tab bar hidden when no custom workspaces exist
- New containers only appear in "All" until explicitly assigned
- Deleting active workspace falls back to "All"
- Offline bridge containers show "[displayName] offline" using stored name from source members
- Stale member IDs in workspace are harmless (won't match any live container/session)
- Adding a source includes all current and future sessions (and their windows)
- Adding a session includes all its current and future windows
- Inherited membership (from source) is shown in UX as checked + disabled

---

## File Summary

| File | Type | Change |
|------|------|--------|
| `backend/app/schemas/__init__.py` | Modify | Add workspace member union + 5 models |
| `backend/app/store.py` | Modify | Add ~50 lines workspace CRUD |
| `backend/app/api/workspaces.py` | **New** | ~50 lines, 5 endpoints |
| `backend/app/main.py` | Modify | 2 lines: import + include_router |
| `frontend/src/types/index.ts` | Modify | Add `WorkspaceMember` union + 2 interfaces |
| `frontend/src/api/client.ts` | Modify | Add 5 methods to interface |
| `frontend/src/api/httpClient.ts` | Modify | Add 5 method implementations |
| `frontend/src/mocks/mockApi.ts` | Modify | Add mock implementations |
| `frontend/src/utils/sidebarState.ts` | Modify | Add 2 localStorage functions |
| `frontend/src/utils/workspaceFilter.ts` | **New** | ~60 lines, pure filtering logic |
| `frontend/src/components/WorkspaceTabs.tsx` | **New** | ~120 lines, tab bar component |
| `frontend/src/components/Sidebar.tsx` | Modify | Query, state, filterWorkspace(), offline placeholders, render tabs |
| `frontend/src/components/ContainerNode.tsx` | Modify | Accept FilterResult prop, filter sessions, workspace assignment submenu |
| `frontend/src/components/SessionItem.tsx` | Modify | Add three-dot menu with workspace assignment submenu |

## Implementation Order

1. Backend: schemas → store → router → main.py registration
2. Frontend: types → API client → localStorage helpers
3. Frontend: workspaceFilter utility → WorkspaceTabs component → Sidebar integration → ContainerNode/SessionItem filtering + menus

## Verification

1. `curl GET /api/v1/workspaces` → returns default "All" workspace
2. Create workspace via API, verify `data/workspaces.json` written
3. Frontend: tab bar appears after creating a workspace
4. Assign a source → all its sessions visible in workspace
5. Assign a session → only that session visible (not other sessions in same source)
6. New session appears in source → automatically visible in workspace that has the source as member
7. Selected terminal persists when switching to workspace that doesn't contain it
8. Rename/delete/reorder tabs work
9. localStorage persists active tab across page refresh
10. Disconnect bridge → workspace shows "[name] offline" placeholder for source members
11. Reconnect bridge → container reappears normally
12. Three-dot menu on session shows inherited membership as checked + disabled
