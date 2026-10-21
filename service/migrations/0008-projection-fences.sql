CREATE SEQUENCE projection_fence;
ALTER TABLE jobs ADD COLUMN projection_fence bigint NOT NULL DEFAULT 0;
