# PASA Benchmark Results Summary

Results matching the tables in the published paper.

## Table 2 -- Policy Compliance (Section 5.1)

| Mode | Notifications | Violations | Compliance |
|------|--------------|------------|------------|
| Governed | 80 | 0 | 100% |
| Ungoverned | 158 | 78 | 50.6% |
| Keyword | -- | 802 | -- |

## Table 3 -- Recall for Authorized Content (Section 5.1)

| Mode | Precision | Recall | F1 |
|------|-----------|--------|-----|
| Governed | 1.00 | 1.00 | 1.00 |
| Ungoverned | 1.00 | 1.00 | 1.00 |

Both modes achieve perfect recall -- governance filters unauthorized
content without dropping authorized notifications.

## Table 4 -- Policy Dimension Ablation (Section 5.2, PASA v2)

| Configuration | Notifications | Violations | Block Rate |
|---------------|--------------|------------|------------|
| Ungoverned | 309 | 223 | -- |
| Level only | 188 | 102 | 54.3% |
| + commercial_opt_out | 159 | 73 | 67.3% |
| + training_opt_out | 142 | 56 | 74.9% |
| All dimensions | 86 | 0 | 100% |

Each policy dimension contributes independently. No single dimension
is sufficient alone.

## Table 5 -- Curation Guarantee (Section 5.2, PASA v2)

| Mode | Notifications | From validated | From unvalidated | Leak rate |
|------|--------------|---------------|-----------------|-----------|
| With curation | 149 | 149 | 0 | 0% |
| Without curation | 189 | 149 | 40 | 21.2% |

Chunk status: 738 current (validated), 262 proposed (unvalidated).

## Table 6 -- Scalability (Section 5.3)

| Subscriptions | p50 (ms) | p95 (ms) | Mean (ms) |
|---------------|----------|----------|-----------|
| 10 | 0.63 | 1.36 | 0.70 |
| 50 | 0.71 | 1.38 | 0.75 |
| 100 | 1.29 | 2.10 | 1.29 |
| 500 | 3.01 | 4.98 | 3.11 |

Governed mode (93 subs): p50=0.97ms, p95=1.56ms, mean=1.08ms.
Ungoverned mode (93 subs): p50=1.39ms, p95=2.49ms, mean=1.55ms.
Governed is 30.5% faster (fewer notifications to emit).

## Adversarial Scenario

| Metric | Value |
|--------|-------|
| Sample size | 50 adversarial chunks |
| Would-be violations (ungoverned) | 35 |
| Actual violations (governed) | 0 |
| Prevention rate | 100% |
