import { z } from 'zod';

export const jobSchema = z.object({
  user: z.string(),
  agent_id: z.string(),
  prompt: z.string().optional(),
  schedule: z.string(),
  timezone: z.string().optional().default('UTC'),
  enabled: z.boolean().optional().default(true),
});

export const JobsSchema = z.record(jobSchema);

export type TJobConfig = z.infer<typeof jobSchema>;
export type TJobsConfig = z.infer<typeof JobsSchema>;
