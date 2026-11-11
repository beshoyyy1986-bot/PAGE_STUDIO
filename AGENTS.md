<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules
- Customers are keyed by Facebook conversation id; participant id and name are stored separately and message counts are never used. Why: the goal is the page's real conversation count and opening the right thread.
- Cloud browser control is stateless: every server function opens a short CDP WebSocket (`src/lib/cdp.server.ts`) to the address stored in `cloud_sessions`. Why: Workers keep no memory between requests, and this makes resume after refresh/restart work.
- A cloud session is marked closed only after it disappears from CloudBrowser's `/Browser/Get` list. Why: `/Browser/Close` returns success even for unknown addresses.
- CloudBrowser `ws://` addresses must be upgraded to `wss://` before connecting. Why: the plain address only answers with a redirect.
- Rows are marked `in_progress` before a send and never auto-resent. Why: an interrupted send may already have delivered the message.
- Server actions that spend cloud credits call `assertOwner`: the first signed-in account claims the single `app_owner` row. Why: the tool is for one owner.
- Server function modules live in `src/lib/*.functions.ts`; `src/server/**` is blocked from client imports.
