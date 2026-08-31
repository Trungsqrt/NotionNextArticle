GLOBAL PROJECT RULES

This task is a visual refinement task.

Do NOT:

- rewrite the application
- change framework architecture
- change routing
- change APIs
- change database logic
- change data models
- change content
- change article data
- replace working components unnecessarily
- introduce a new UI library
- introduce a new CSS framework
- modify the light theme unless explicitly requested
- change behavior just to make the implementation easier

Prefer:

- existing components
- existing design tokens
- existing theme architecture
- minimal CSS/class changes
- small, isolated modifications
- reusable styling patterns

When uncertain, inspect the existing implementation before making assumptions.

When a visual change can be achieved through an existing token or shared class, prefer that over creating component-specific values.