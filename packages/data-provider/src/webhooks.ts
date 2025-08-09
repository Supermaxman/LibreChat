import { z } from 'zod';

const githubAuthSchema = z.object({
  type: z.literal('github'),
  secret: z.string(),
  algorithm: z.enum(['sha1', 'sha256']).default('sha256'),
  signature_header: z.string().optional(),
});

const headerAuthSchema = z.object({
  type: z.literal('header'),
  secret: z.string(),
  header: z.string().default('authorization'),
  prefix: z.string().optional(),
});

const microsoftAuthSchema = z.object({
  type: z.literal('microsoft'),
  clientState: z.string(),
});

export const webhookAuthSchema = z.discriminatedUnion('type', [
  githubAuthSchema,
  headerAuthSchema,
  microsoftAuthSchema,
]);

export const webhookSchema = z.object({
  agent_id: z.string(),
  /**
   * Email address of the user to attribute the webhook message to.
   * If your system uses emails as user IDs, use the same value here.
   */
  user: z.string().optional(),
  prompt: z.string().optional(),
  auth: webhookAuthSchema.optional(),
});

export const WebhooksSchema = z.record(webhookSchema);

export type TWebhookAuth = z.infer<typeof webhookAuthSchema>;
export type TWebhookConfig = z.infer<typeof webhookSchema>;
export type TWebhooksConfig = z.infer<typeof WebhooksSchema>;

