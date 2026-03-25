import { z } from "zod";

export const CreateSessionBodySchema = z.object({
  name: z.string().max(256).optional(),
});

export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;
