/**
 * ULID-based opaque IDs with type prefixes.
 * All IDs are `<prefix>_<ulid>` strings.
 */

import { ulid } from 'ulid';

export type SessionId = `ses_${string}`;
export type TurnId = `trn_${string}`;
export type StepId = `stp_${string}`;
export type ItemId = `itm_${string}`;
export type ToolCallId = `call_${string}`;
export type WorkspaceId = `wrk_${string}`;
export type EventId = `evt_${string}`;
export type AgentId = `agt_${string}`;

export type AnyId = SessionId | TurnId | StepId | ItemId | ToolCallId | WorkspaceId | EventId | AgentId;

export const ID_PREFIXES = {
    session: 'ses_',
    turn: 'trn_',
    step: 'stp_',
    item: 'itm_',
    toolCall: 'call_',
    workspace: 'wrk_',
    event: 'evt_',
    agent: 'agt_',
} as const;

export type IdType = keyof typeof ID_PREFIXES;

export function generateId(type: IdType): string {
    return `${ID_PREFIXES[type]}${ulid()}`;
}
