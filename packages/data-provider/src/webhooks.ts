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
  agent_id: z.string().optional(),
  user: z.string(),
  prompt: z.string().optional(),
  auth: webhookAuthSchema.optional(),
});

export const WebhooksSchema = z.record(webhookSchema);

export type TWebhookAuth = z.infer<typeof webhookAuthSchema>;
export type TWebhookConfig = z.infer<typeof webhookSchema>;
export type TWebhooksConfig = z.infer<typeof WebhooksSchema>;

// Standardized WebhookResponse shape expected from proxied MCP webhook endpoints
export type WebhookResponse = {
  reqResponseCode: number;
  reqResponseContent: string;
  reqResponseContentType?: 'json' | 'text';
  promptContent?: string;
};
