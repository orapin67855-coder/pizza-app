-- Prototype exercise definitions. EVERY threshold here is a placeholder and every row is a
-- draft: a physiotherapist must review and approve before they count as real guidance.
-- Mirrors ai/src/exercises/defaults.ts (the offline fallback used by the app).

insert into public.exercises (id, version, name, category, needs_carer, metric, criteria)
values
  ('arm-raise', 1, 'High arm raise', 'A', false, 'shoulder-angle',
   '{"up": 150, "down": 40, "minRepMs": 600}'),
  ('seated-alt-arm', 1, 'Seated alternating arm raise', 'A', false, 'alt-shoulder-angle',
   '{"up": 140, "down": 40, "minRepMs": 400}'),
  ('torso-twist', 1, 'Seated trunk rotation', 'A', false, 'trunk-rotation',
   '{"up": 25, "down": 10, "minRepMs": 500}'),
  ('sit-stand', 1, 'Sit-to-stand from a chair', 'B', true, 'knee-angle',
   '{"up": 160, "down": 110, "minRepMs": 800}'),
  ('big-step', 1, 'Long steps, rhythmic walking', 'C', true, 'stride-ratio',
   '{"up": 0.6, "down": 0.2, "minRepMs": 250}')
on conflict (id, version) do nothing;
