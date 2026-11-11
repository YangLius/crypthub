/**
 * hash-wasm 的 package.json 只有顶层 "types" 字段而无 exports.map，
 * 部分工具按 main(dist/index.umd.js) 解析时找不到声明。此 shim 把
 * 真实类型重导出到包名下，保证任何解析策略都能拿到类型。
 */
declare module "hash-wasm" {
 export * from "hash-wasm/dist/lib/index.js";
}
