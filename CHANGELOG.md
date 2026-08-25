# pi-harness-delegate

## 0.2.2

### Patch Changes

- [#7](https://github.com/yorch/pi-harness-delegate/pull/7) [`b61c55d`](https://github.com/yorch/pi-harness-delegate/commit/b61c55d7e7cabd46360e066e17c662c08fb100bd) Thanks [@yorch](https://github.com/yorch)! - fix: tighten harness parsers with live JSONL fixtures (opencode step_finish, amp message_update, codex error)

## 0.2.1

### Patch Changes

- [#6](https://github.com/yorch/pi-harness-delegate/pull/6) [`9fe2808`](https://github.com/yorch/pi-harness-delegate/commit/9fe2808e0d13beb3e6d318f0d16311070cb1fc26) Thanks [@yorch](https://github.com/yorch)! - chore: support Node 22,24,26
  
  Support Node 22, 24 and 26 via engines "22 || 24 || 26" and @types/node 22.15.32. CI now matrix 22/24/26, release stays on 26.

## 0.2.0

### Minor Changes

- [`ae49b9c`](https://github.com/yorch/pi-harness-delegate/commit/ae49b9cba563cbb607e1faee435338bd1e5be976) Thanks [@yorch](https://github.com/yorch)! - feat: Health & UX — /delegate status health check, per-harness detectAll UI, history/list filters by harness

## 0.1.1

### Patch Changes

- [#1](https://github.com/yorch/pi-harness-delegate/pull/1) [`9a4169b`](https://github.com/yorch/pi-harness-delegate/commit/9a4169ba165cdbcc25d06c6e3630aa3c2aeb54ea) Thanks [@yorch](https://github.com/yorch)! - chore: migrate to Bun + Node 26 + Biome + changesets release
  
  Update dependencies to latest: @earendil-works/* 0.84.3, @biomejs/biome 2.5.10, @changesets/cli 3.0.1, @changesets/changelog-github 1.0.0, @types/node 26.3.0, typescript 7.0.2, typebox 1.3.18. Switch formatter to 2-space indentation.
