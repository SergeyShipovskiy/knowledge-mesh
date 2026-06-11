export type EntityType =
  | "Project"
  | "Note"
  | "Decision"
  | "Idea"
  | "Person"
  | "Technology"
  | "Meeting"
  | "Agent"
  | "Claim"
  | "Problem"
  | "Constraint"
  | "Pattern"
  | "Service"
  | "Topic"
  | "BoundedContext";

export type RelationType =
  | "RELATES_TO"
  | "MENTIONS"
  | "USES"
  | "SUPPORTS"
  | "CONTRADICTS"
  | "SUPERSEDES"
  | "CREATED_BY"
  | "ADDRESSES"
  | "EXTRACTED_FROM"
  | "PUBLISHES_TO"
  | "SUBSCRIBES_TO"
  | "CALLS_HTTP"
  | "BELONGS_TO";

export interface DocumentRecord {
  id: string;
  path: string;
  title: string;
  content: string;
  content_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface ChunkRecord {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
}

export interface EntityRecord {
  id: string;
  type: EntityType;
  name: string;
  metadata: Record<string, unknown>;
}

export interface SearchResult {
  document_id: string;
  path: string;
  title: string;
  chunk_content: string;
  similarity: number;
}
