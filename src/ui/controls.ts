import type { ParamSpec, ParamValues } from "../models/types";

/**
 * Builds sliders, checkboxes and dropdowns from a model's parameter specs. `onChange`
 * receives the spec that changed so the host can decide whether to reset.
 */
export function renderParamControls(
  container: HTMLElement,
  specs: ParamSpec[],
  values: ParamValues,
  onChange: (spec: ParamSpec) => void,
): void {
  container.replaceChildren();

  for (const spec of specs) {
    const row = document.createElement("div");
    row.className = "param";
    const id = `param-${spec.key}`;

    if (spec.kind === "number") {
      const label = document.createElement("label");
      label.htmlFor = id;
      const name = document.createElement("span");
      name.textContent = spec.label;
      const readout = document.createElement("span");
      readout.className = "readout";
      label.append(name, readout);

      const input = document.createElement("input");
      input.type = "range";
      input.id = id;
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(values[spec.key]);

      const show = () => (readout.textContent = formatNumber(Number(input.value), spec.step));
      show();
      input.addEventListener("input", () => {
        values[spec.key] = Number(input.value);
        show();
        if (!spec.resetOnChange) onChange(spec);
      });
      // Resetting on every slider tick would be jarring for things like body
      // count, so reset-triggering params apply when the drag ends.
      input.addEventListener("change", () => {
        if (spec.resetOnChange) onChange(spec);
      });
      row.append(label, input);
    } else if (spec.kind === "choice") {
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = spec.label;
      const input = document.createElement("select");
      input.id = id;
      for (const o of spec.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        input.append(opt);
      }
      input.value = String(values[spec.key]);
      input.addEventListener("change", () => {
        values[spec.key] = input.value;
        onChange(spec);
        // Hand the keyboard back so Space / R keep driving the simulation.
        input.blur();
      });
      row.append(label, input);
    } else {
      row.classList.add("param-toggle");
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = spec.label;
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = id;
      input.checked = Boolean(values[spec.key]);
      input.addEventListener("change", () => {
        values[spec.key] = input.checked;
        onChange(spec);
      });
      row.append(input, label);
    }

    container.append(row);
  }
}

function formatNumber(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(decimals);
}
