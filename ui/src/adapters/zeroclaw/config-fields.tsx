import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

export function ZeroClawConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Gateway URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "gatewayUrl", String(config.gatewayUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "gatewayUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://localhost:42617"
        />
      </Field>

      <SecretField
        label="API Key"
        value={
          isCreate
            ? ""
            : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))
        }
        onCommit={(v) => mark("adapterConfig", "apiKey", v || undefined)}
        placeholder="ZeroClaw bearer token"
      />

      {!isCreate && (
        <Field label="Timeout (seconds)">
          <DraftInput
            value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "600"))}
            onCommit={(v) => {
              const parsed = Number.parseInt(v.trim(), 10);
              mark(
                "adapterConfig",
                "timeoutSec",
                Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
              );
            }}
            immediate
            className={inputClass}
            placeholder="600"
          />
        </Field>
      )}
    </>
  );
}
