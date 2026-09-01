# Example: hello-world

The smallest workflow that exercises everything: an agent node with a
structured output and a gate, a fan-out with one gated node per item, and
an aggregator. Five short Claude calls in total on the default topic.

```
flowy run examples/hello-world                 # proposes 3 ideas, pauses at the gate
flowy status -d examples/hello-world
flowy approve ideas -d examples/hello-world --set notes="keep them under 100 words"
flowy run examples/hello-world --run <run-id>  # drafts 3 stories in parallel, pauses at each
flowy approve draft -d examples/hello-world --item story/<slug> --set approved=true
flowy skip story/<slug> -d examples/hello-world
flowy run examples/hello-world --run <run-id>  # writes the anthology
```

Or `flowy serve examples/hello-world` and click through the same steps.
