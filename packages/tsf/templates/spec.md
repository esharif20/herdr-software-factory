# Spec: <name>

Goal: one sentence.

## T-1 <title>
- depends: none
- parallel: yes
- writes: src/a/**
- gated: no
- done when: observable behaviour, with the test that shows it

## T-2 <title>
- depends: T-1
- parallel: no
- writes: src/b/**
- gated: yes
- done when: ...

Markers: `depends` lists ticket ids that must be done first; `parallel: yes` means no file overlap with other parallel tickets.
