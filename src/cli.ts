#!/usr/bin/env bun
/**
 * cli.ts — terminal entry point.
 *
 * P0 scope: prove the Medplum adapter connects. This is intentionally minimal —
 * the full profile store, audit log, policy gate, and the rest of the verb
 * surface land in P1+. For now, connection config comes from env with
 * local-Medplum defaults so `bun run cli ping` works the moment Medplum is up.
 */

import { createMedplumAdapter, type MedplumAuth } from "./adapters/medplum/index.ts";
import type { SoRAdapter } from "./adapters/sor.ts";

function resolveAuth(): MedplumAuth {
  const token = process.env.MEDPLUM_ACCESS_TOKEN;
  if (token) return { mode: "token", accessToken: token };

  const clientId = process.env.MEDPLUM_CLIENT_ID;
  const clientSecret = process.env.MEDPLUM_CLIENT_SECRET;
  if (clientId && clientSecret) return { mode: "clientCredentials", clientId, clientSecret };

  return {
    mode: "password",
    email: process.env.MEDPLUM_EMAIL ?? "admin@example.com",
    password: process.env.MEDPLUM_PASSWORD ?? "medplum_admin",
  };
}

function adapter(): SoRAdapter {
  return createMedplumAdapter({
    baseUrl: process.env.MEDPLUM_BASE_URL ?? "http://localhost:8103",
    auth: resolveAuth(),
  });
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  const sor = adapter();

  switch (verb) {
    case "ping": {
      const ok = await sor.ping();
      console.log(ok ? `✓ connected to ${sor.kind}` : `✗ could not reach ${sor.kind}`);
      process.exit(ok ? 0 : 1);
    }

    case "verify-patient": {
      const name = arg("--name");
      const dob = arg("--dob");
      if (!name || !dob) {
        console.error("usage: cli verify-patient --name <name> --dob <YYYY-MM-DD>");
        process.exit(2);
      }
      const match = await sor.verifyPatient(name, dob);
      console.log(match ? JSON.stringify(match, null, 2) : "no patient found");
      process.exit(match ? 0 : 1);
    }

    default:
      console.log("atomic-healthcare cli (P0)");
      console.log("verbs:");
      console.log("  ping");
      console.log("  verify-patient --name <name> --dob <YYYY-MM-DD>");
      process.exit(verb ? 2 : 0);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
