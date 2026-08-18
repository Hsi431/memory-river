// 模擬原生 binding 缺失的 nodejieba:import 得到、一呼叫就丟。
function throwBindingError() {
  const error = new Error(
    'nodejieba native binding was not found at /fake/build/Release/nodejieba.node.',
  );
  error.code = 'BINDING_NOT_FOUND';
  throw error;
}

export default {
  cut: throwBindingError,
  cutAll: throwBindingError,
  cutForSearch: throwBindingError,
};
