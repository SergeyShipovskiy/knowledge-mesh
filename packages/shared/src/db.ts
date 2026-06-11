import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool(config.postgres);

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
