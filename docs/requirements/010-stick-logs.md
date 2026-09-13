Status: reference — user note (sticky TUI shipped 0c035a21)

from last commits, we add the stickness with following 
 ▌✓ Stage 2C — BDD Review      
   [2026-08-14T10:49:34.975+08:00] Stage start: Stage 2C — BDD Review at 2026-08-14T10:49:34.975+08:00
   [2026-08-14T10:53:14.974+08:00] Stage end: Stage 2C — BDD Review status=ok at 2026-08-14T10:53:14.974+08:00 duration=3m 40s
   
   
but actually each stage has more logs, want more logs stick, a full stick logs i want below(take Stage 2C — BDD Review  for example ), all stages and all phases should at least include following logs sticked

[2026-08-14T10:49:34.975+08:00] ▶ Stage 2C — BDD Review                                                                 
[2026-08-14T10:49:34.990+08:00] bddReview: agent bdd-reviewer working
[2026-08-14T10:49:35.007+08:00] agent pipeline.bddReview: start agent=bdd-reviewer backend=session access=source-read-only timeout=role-default thinking=high cwd=/home/jenningsl/development/personal/jenningsloy318/pi-omisis/.worktree/01-interface-contracts-schemas model=antigravity/gemini-3.6-flash controlKeys=title,date,verdict,summary,findings,priorFindingResolutions,dimensions promptChars=2589
[2026-08-14T10:49:35.129+08:00] session pipeline.bddReview: start timeout=480000ms cwd=/home/jenningsl/development/personal/jenningsloy318/pi-omisis/.worktree/01-interface-contracts-schemas access=source-read-only controlKeys=title,date,verdict,summary,findings,priorFindingResolutions,dimensions
[2026-08-14T10:53:14.971+08:00] agent pipeline.bddReview: end elapsed=219964ms control=yes model=unknown
[2026-08-14T10:53:14.972+08:00] bddReview: doc → 04-bdd-review.md
[2026-08-14T10:53:14.973+08:00] bddReview: rendered /home/jenningsl/development/personal/jenningsloy318/pi-omisis/.worktree/01-interface-contracts-schemas/docs/specifications/01-interface-contracts-schemas/04-bdd-review.md (10235 bytes)
[2026-08-14T10:53:14.974+08:00] Stage end: Stage 2C — BDD Review status=ok at 2026-08-14T10:53:14.974+08:00 duration=3m 40s
