-- Seed reserved labels for all existing companies
-- These labels carry semantic meaning for assignment and filtering

INSERT INTO labels (company_id, name, color, created_at, updated_at)
SELECT
  c.id,
  lbl.name,
  lbl.color,
  now(),
  now()
FROM companies c
CROSS JOIN (VALUES
  ('requires_human', '#ef4444'),
  ('bug', '#f97316'),
  ('infrastructure', '#8b5cf6'),
  ('frontend', '#3b82f6'),
  ('backend', '#10b981'),
  ('design', '#ec4899'),
  ('research', '#6366f1'),
  ('operations', '#14b8a6')
) AS lbl(name, color)
ON CONFLICT (company_id, name) DO NOTHING;
