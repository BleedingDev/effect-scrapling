import { Effect, Schema } from "effect";
import {
  E9CapabilitySliceEvidenceSchema,
  runE9CapabilitySlice,
  runE9CapabilitySliceEncoded,
} from "../src/e9-capability-slice.ts";

export { E9CapabilitySliceEvidenceSchema };

export async function runE9CapabilitySliceExample() {
  return Effect.runPromise(runE9CapabilitySlice());
}

export async function runE9CapabilitySliceExampleEncoded() {
  return Effect.runPromise(runE9CapabilitySliceEncoded());
}

if (import.meta.main) {
  const evidence = await runE9CapabilitySliceExampleEncoded();
  const encoded = Schema.decodeUnknownSync(E9CapabilitySliceEvidenceSchema)(evidence);
  console.log(JSON.stringify(encoded, null, 2));
}
