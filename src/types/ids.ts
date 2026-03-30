/**
 * ULID-based opaque IDs with type prefixes.
 * All IDs are `<prefix>_<ulid>` strings.
 */

export type SessionId = `ses_${string}`;
export type TurnId = `trn_${string}`;
export type StepId = `stp_${string}`;
export type ItemId = `itm_${string}`;
export type ToolCallId = `call_${string}`;
export type WorkspaceId = `wrk_${string}`;

export type AnyId = SessionId | TurnId | StepId | ItemId | ToolCallId | WorkspaceId;

const ID_PREFIXES = {
    session: 'ses_',
    turn: 'trn_',
    step: 'stp_',
    item: 'itm_',
    toolCall: 'call_',
    workspace: 'wrk_',
} as const;

export function generateId(type: keyof typeof ID_PREFIXES): string {
    // TODO: Replace with proper ULID generation (e.g., ulid package)
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10);
    return `${ID_PREFIXES[type]}${timestamp}${random}`;
}
