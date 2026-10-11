import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
  schema: z.object({
    title: z.string().min(1),
    company: z.string().min(1),
    period: z.string().min(1),
    category: z.string().min(1),
    summary: z.string().min(1),
    skills: z.array(z.string().min(1)).min(1),
    featured: z.boolean(),
    order: z.number().int().nonnegative(),
    draft: z.boolean(),
    role: z.string().optional(),
    thumbnail: z.string().optional(),
    repository: z.string().url().optional(),
  }),
});

export const collections = { projects };
