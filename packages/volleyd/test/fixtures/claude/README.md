Transcripts of `claude auth login` (Claude Code 2.1.303) in a fresh, signed-out profile, as
recorded by the accounts spike (`docs/claude-accounts-spike.md`, section (b)). The OAuth
`client_id`, `state` and `code_challenge` values are replaced with placeholders.

- `auth-login-tmux.txt`: `tmux capture-pane -p -J` of the session (no escapes).
- `auth-login-piped.txt`: the raw bytes on a piped stdout: the printed link wrapped in an OSC-8
  hyperlink, so the URL appears twice.
- `browser-url.txt`: what `claude auth login` passed to `$BROWSER` (the localhost-callback URL).
