# Feishu Topic Closed Loop

## Goal

Let a Feishu group use one Siclaw Agent as a natural, shared conversation inside
one Topic: the first message mentions the bot, then authorized participants can
continue in that Topic without mentioning it again. The main group and other
Topics must remain unaffected.

This is a third context mode. It does not change the existing Team or Personal
contracts.

## Modes

| Mode | Session key | Follow-up without `@bot` | Reply surface |
| --- | --- | --- | --- |
| Team (`shared`) | `chat:<chat_id>` | Main-group chatter may be buffered; Topic follow-ups do not run the Agent | Main group |
| Personal (`per_user`) | `<participant>:lark_thread:<root_id>` | Only the same participant can reuse their Topic session | Topic |
| Topic (`topic`) | `lark_thread:<root_id>` | Any authorized participant can reuse a claimed Topic | Topic |

## Claim and isolation rules

1. An explicit `@bot` message is allowed to create the Topic session.
2. An unmentioned Topic follow-up is resolved with `conversation_existing_only`.
   It can reuse an existing Topic session, but cannot create one.
3. The Topic root ID is the complete session scope in Topic mode. Sender IDs are
   deliberately excluded so authorized participants share one context.
4. A different Topic root produces a different key. If it has not been claimed,
   the runtime receives no binding and stays silent.
5. Main-group messages without `@bot` do not enter Topic sessions.
6. `/new` resets only the current Topic session. It never resets another Topic
   or the whole group.

## Authorization boundary

Session sharing does not bypass access control. Sicore resolves every incoming
turn with the current sender identity before returning the Topic session. An
unauthorized sender receives no reusable binding for an unmentioned follow-up;
an explicit mention follows the normal access-denied flow.

Standalone Siclaw supports the same session-key and existing-only rules for its
open group bots. Gated, platform-authorized groups remain a Sicore capability.

## Product controls

Topic mode is available from:

- the Sicore channel-binding selector;
- the standalone Siclaw Agent settings selector; and
- the Feishu `/mode` card.

New group bindings still default to Team mode. Existing legacy or unknown mode
values still fail closed to Personal mode; they are never inferred as shared.

## Feishu prerequisite

The app must receive group messages without a bot mention
(`im:message.group_msg`). Without that permission, Feishu does not deliver the
follow-up event, so no runtime implementation can continue the Topic naturally.
