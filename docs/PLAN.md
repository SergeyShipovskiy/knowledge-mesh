# Knowledge Mesh v1

> **Status (2026-06-11):** this is the original hackathon design document,
> kept for history. The system is built and exceeds this plan (hybrid
> retrieval, semantic+structural LLM extraction, graph/impact tools, audited
> note edits, event-driven freshness). Current state and what's next live in
> [ROADMAP.md](ROADMAP.md); the live description is the repo
> [README](../README.md). The one deliberate deviation: the vault is the
> user's existing Obsidian vault, not a repo-local `vault/` folder.

## Vision

Build a shared knowledge layer for humans and AI agents.

The system should:

- Store personal and project knowledge.
- Be editable through Obsidian.
- Build a semantic index in PostgreSQL.
- Build a relationship graph in Neo4j.
- Expose a unified API for agents.
- Support Claude Code, Codex, MCP clients, and later Paperclip.

The long-term goal is not a note-taking application.

The goal is a persistent knowledge and memory layer shared between humans and AI systems.

---

# High-Level Architecture

text Obsidian Vault       ↓ Markdown Watcher       ↓ Indexer       ↓ Postgres + pgvector       ↓ Neo4j Graph Projection       ↓ Knowledge API       ↓ MCP Server       ↓ Agents 

---

# Core Principles

## Human First

Humans must always be able to:

- read knowledge
- edit knowledge
- understand knowledge

Knowledge should never become locked inside a graph database.

---

## Single Source of Truth

For v1:

text Markdown files = human source Postgres = operational source Neo4j = graph projection 

Neo4j must never become the only place where information exists.

---

## One Memory For All Agents

Do not build separate memories for:

- Claude Code
- Codex
- Paperclip
- future agents

Build one shared memory layer.

Agents become clients of the same system.

---

# Repository Structure

text knowledge-mesh/  ├── apps/ │   ├── api/ │   ├── indexer/ │   └── mcp-server/ │ ├── packages/ │   └── shared/ │ ├── docs/ │   └── PLAN.md │ └── vault/ 

---

# Obsidian Vault Structure

text vault/  ├── projects/ ├── ideas/ ├── decisions/ ├── people/ ├── technologies/ ├── meetings/ ├── daily/ ├── agents/ └── archive/ 

---

# Phase 1 — Foundation

## Goal

Validate the complete pipeline.

### Success Criteria

A markdown note:

text vault/ideas/neo4j.md 

must become:

text Markdown     ↓ Postgres     ↓ Neo4j 

and be visible inside Neo4j Browser.

---

## Infrastructure

### PostgreSQL

Database:

text knowledge 

Install:

text pgvector 

### Neo4j

Run locally using Podman.

Browser:

text http://localhost:7474 

### Obsidian

Acts as the primary human interface.

---

# Phase 2 — Indexer

## Goal

Convert markdown into searchable knowledge.

### Responsibilities

For every file:

1. Read markdown.
2. Extract metadata.
3. Generate content hash.
4. Store document.
5. Split into chunks.
6. Generate embeddings.
7. Store embeddings.
8. Trigger graph projection.

---

# PostgreSQL Schema

## documents

text id path title content content_hash created_at updated_at 

## chunks

text id document_id chunk_index content embedding 

## entities

text id type name metadata 

## relations

text id source_entity_id target_entity_id relation_type confidence 

## sync_state

text path last_hash indexed_at 

---

# Phase 3 — Graph Projection

## Goal

Generate a graph representation of knowledge.

---

## Node Types

text Project Note Decision Idea Person Technology Agent 

---

## Relationship Types

text RELATES_TO MENTIONS USES SUPPORTS CONTRADICTS SUPERSEDES CREATED_BY 

---

## Example

text Project: Knowledge Mesh        USES  Technology: Neo4j        SUPPORTED_BY  Decision: Graph Projection 

---

# Phase 4 — Knowledge API

## Goal

Provide a unified interface.

---

## Endpoints

### Search

http GET /search?q= 

### Context

http GET /context?q= 

### Entity

http GET /entity/{id} 

### Remember

http POST /remember 

### Proposal

http POST /proposal 

---

# Phase 5 — MCP Server

## Goal

Expose memory to AI agents.

---

## Tools

text knowledge_search knowledge_context knowledge_remember knowledge_link 

---

## Supported Clients

text Claude Code Codex Paperclip Future Agents 

---

# Phase 6 — Agent Contributions

## Rule

Agents never overwrite human notes.

---

## Allowed

text Agent Notes Agent Observations Agent Proposals Agent Links 

---

## Storage

text vault/agents/  ├── claude/ ├── codex/ ├── paperclip/ └── system/ 

---

# Hackathon Scope

## Must Have

- Obsidian vault
- PostgreSQL storage
- Neo4j graph
- Markdown indexer
- Knowledge API

---

## Nice To Have

- MCP server
- Claude Code integration
- Automatic entity extraction
- Graph visualization improvements

---

## Out Of Scope

- Multi-user support
- Permissions
- SaaS architecture
- Billing
- Real-time collaboration
- Long-term memory optimization

---

# MVP Definition

The project is considered successful when:

1. A note is created in Obsidian.
2. The note is indexed into PostgreSQL.
3. A graph node appears in Neo4j.
4. An agent can retrieve the note through the API.
5. The source of the knowledge can be explained and traced.

At this point the foundation of a shared human-agent knowledge graph exists.