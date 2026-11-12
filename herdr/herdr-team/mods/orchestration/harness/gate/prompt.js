// Prompt section: the gate. Lead only.
export default (key) => key ? `For a gated ticket the worker brief must include \`sh ~/.config/herdr-app/mods/orchestration/harness/gate/gate.sh ${key} <ticket> <build-dir>\`. ` : "";
