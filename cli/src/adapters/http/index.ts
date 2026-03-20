import type { CLIAdapterModule } from "@zeroinc/adapter-utils";
import { printHttpStdoutEvent } from "./format-event.js";

export const httpCLIAdapter: CLIAdapterModule = {
  type: "http",
  formatStdoutEvent: printHttpStdoutEvent,
};
