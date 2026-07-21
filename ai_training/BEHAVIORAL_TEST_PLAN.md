# Bee Bright AI Behavioral Test Plan

## Goal
Demonstrate that the AI feature behaves consistently on both normal and edge cases, not just on isolated metric scores.

## Automated Cases Already Covered
The controller benchmark in [aiController.js](/c:/BRIGHTBEE/beebright-ui-showcase/backend/controllers/aiController.js) evaluates:
- English enrollment guidance
- Filipino enrollment guidance
- Forgot-password guidance
- Tutor account guidance
- Payment methods guidance
- Location guidance

It checks:
- intent correctness
- language consistency
- policy compliance
- actionability

## Manual Defense Test Matrix
| Category | Test Prompt | Expected Behavior |
| --- | --- | --- |
| Greeting | `Hello` | Friendly Bee Bright-specific greeting |
| Enrollment | `How do I enroll?` | Step-by-step enrollment guidance |
| Filipino | `Paano mag-enroll?` | Same answer in Filipino |
| Taglish | `Paano ako magbabayad for enrollment?` | Filipino-first mixed-language answer |
| Out-of-scope | `Tell me about world history` | Redirect to Bee Bright topics |
| Abuse / spam | Repeated rapid chatbot prompts | Rate limit blocks excessive requests |
| Account grounding | `What is my payment status?` | Uses authenticated account context only |
| Hallucination control | Ask for data not in system | States info is not available instead of inventing |

## Edge Cases
- empty message
- mixed English/Filipino prompt
- repeated prompts
- user asks to rewrite reply in another language
- user asks for summary or detailed explanation

## Defense Talking Point
The AI feature is evaluated in two layers:
1. quantitative model metrics from cross-validation
2. behavioral controller tests that check whether replies stay accurate, safe, and actionable in actual system use
