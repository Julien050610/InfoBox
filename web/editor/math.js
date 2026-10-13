export function renderMathIn(root) {
  if (!root || !globalThis.katex) return;
  for (const node of root.querySelectorAll('[data-math]:not([data-math-rendered])')) {
    const expression = node.textContent || '';
    try {
      globalThis.katex.render(expression, node, {
        displayMode: node.classList.contains('math-block'), throwOnError: false, strict: 'ignore', output: 'htmlAndMathml',
      });
      node.dataset.mathRendered = 'true';
    } catch { /* KaTeX leaves the original expression visible. */ }
  }
}
