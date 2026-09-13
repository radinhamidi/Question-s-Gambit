import { Type, type Static } from "typebox";
import { createJsonValidator } from "../lib/json_validation";

const PiEventSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

const piEventValidator = createJsonValidator(PiEventSchema);

export type PiEvent = Static<typeof PiEventSchema> & Record<string, unknown>;

export function parsePiEventJsonLine(text: string, label: string): PiEvent {
  return piEventValidator.parse(text.trim(), label);
}
