# Git hooks

This repository only allows commit author and committer identity:

```txt
rendotdev <294850895+rendotdev@users.noreply.github.com>
```

Local setup:

```bash
git config user.name "rendotdev"
git config user.email "294850895+rendotdev@users.noreply.github.com"
git config user.useConfigOnly true
git config core.hooksPath .githooks
```

The `pre-commit` hook blocks new commits with the wrong identity. The `pre-push` hook scans pushed commits and blocks any commit whose author or committer is not the required identity.
