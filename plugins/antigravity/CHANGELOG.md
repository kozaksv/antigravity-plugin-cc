# Changelog

## 1.0.1

- Fix a race in background-job concurrency slots: acquire slots via atomic
  `O_EXCL` create on fixed slot names instead of a directory-listing/sort
  protocol, so two same-workspace jobs can never both win the last slot.

## 1.0.0

- Initial version of the Antigravity (agy) plugin for Claude Code
