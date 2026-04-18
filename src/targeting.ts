import { z } from 'zod';

export const TargetingSchema = z.object({
  keywords: z.array(z.string()).optional(),
  titles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  companies: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  organizationNumEmployeesRanges: z.array(z.string()).optional(),
  organizationIndustryTagIds: z.array(z.string()).optional(),
  organizationIndustryKeywords: z.array(z.string()).optional(),
});

export type Targeting = z.infer<typeof TargetingSchema>;
