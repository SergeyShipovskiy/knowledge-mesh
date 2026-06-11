import { z } from "zod";

export const OBJECT_TYPES = [
  "Decision",
  "Idea",
  "Claim",
  "Problem",
  "Constraint",
  "Pattern",
  "Technology",
  "Project",
  "Service",
  "Topic",
  "BoundedContext",
] as const;

export const SEMANTIC_RELATION_TYPES = [
  "RELATES_TO",
  "USES",
  "SUPPORTS",
  "CONTRADICTS",
  "ADDRESSES",
  "SUPERSEDES",
  "PUBLISHES_TO",
  "SUBSCRIBES_TO",
  "CALLS_HTTP",
  "BELONGS_TO",
] as const;

export const ExtractionSchema = z.object({
  objects: z
    .array(
      z.object({
        type: z.enum(OBJECT_TYPES),
        name: z.string().min(1).max(120),
        summary: z.string().min(1),
        confidence: z.number().min(0).max(1),
      })
    )
    .max(60),
  relations: z.array(
    z.object({
      source: z.string().min(1),
      target: z.string().min(1),
      type: z.enum(SEMANTIC_RELATION_TYPES),
      confidence: z.number().min(0).max(1),
    })
  ),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
