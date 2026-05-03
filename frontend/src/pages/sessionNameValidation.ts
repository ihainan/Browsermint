import type { Session } from "../api/client.ts";

export type SessionNameValidationKey =
  | "sessions.browserNameRequired"
  | "sessions.browserNameTooLong"
  | "sessions.browserNameDuplicate";

export function getSessionNameValidationKey(
  name: string,
  sessions: Pick<Session, "name">[]
): SessionNameValidationKey | null {
  const trimmed = name.trim();
  if (!trimmed) return "sessions.browserNameRequired";
  if (trimmed.length > 64) return "sessions.browserNameTooLong";
  const duplicate = sessions.some((session) => session.name?.trim().toLowerCase() === trimmed.toLowerCase());
  if (duplicate) return "sessions.browserNameDuplicate";
  return null;
}

export function getSessionNameValidationError(
  name: string,
  sessions: Pick<Session, "name">[],
  t: (key: SessionNameValidationKey) => string
): string {
  const key = getSessionNameValidationKey(name, sessions);
  return key ? t(key) : "";
}
