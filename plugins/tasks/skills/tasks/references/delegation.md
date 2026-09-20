Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Task delegation creates a hidden worker so routine project work does not crowd
the operator's active thread list. If the linked project has exactly one visible
pinned root thread named `Operations` or ending in ` Operations`, the worker is
nested under it and receives a contract to report questions, blockers, exact
approval needs, and its final outcome there. With no unambiguous Operations
thread, delegation still creates a hidden standalone worker. Manual threads and
threads associated later with `bb tasks attach` keep their existing visibility
and parentage.

Coordinator lookup examines at most 1,000 visible root threads. If the lookup
fails, is incomplete, or finds multiple Operations threads, the worker remains
hidden and standalone, inspectable from its Task.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier default|fast|none`:

```sh
bb tasks preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--service-tier none` clears a tier.
