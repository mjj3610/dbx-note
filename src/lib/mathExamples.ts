/**
 * 常用公式示例（名称 → LaTeX）
 *
 * 块级公式弹窗与行内公式编辑气泡共用同一份清单，保证两处提示一致（对齐参考实现的八条）。
 */
export const MATH_EXAMPLES: Array<{ label: string; latex: string }> = [
  { label: '分数', latex: '\\frac{a}{b}' },
  { label: '上标', latex: 'x^2' },
  { label: '下标', latex: 'x_n' },
  { label: '平方根', latex: '\\sqrt{x}' },
  { label: '求和', latex: '\\sum_{i=1}^n' },
  { label: '积分', latex: '\\int_a^b f(x) dx' },
  { label: '极限', latex: '\\lim_{x \\to \\infty}' },
  { label: '希腊字母', latex: '\\alpha、\\beta、\\pi' },
]
