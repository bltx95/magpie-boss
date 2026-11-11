const formatCompactCount = (() => {
  const formatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
  return (value, divisor, suffix) => value >= divisor
    ? `${formatter.format(value / divisor)}${suffix}`
    : formatter.format(value);
})();
