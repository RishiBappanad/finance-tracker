export * from "./generated/api";
export * from "./generated/types";

// orval's "zod" client target and its "typescript" schemas override both
// independently derive a name for an operation's combined path+query
// params -- for most operations these derivations differ (e.g.
// "ListTransactionsQueryParams" vs "listTransactionsParams"), but for an
// operation combining a required path param with required query params
// (GET /aggregations/{aggType}?start&end, the only one of those in this
// spec so far) both targets land on the exact same name, which `export *`
// can't disambiguate on its own. Explicit re-export after the wildcards
// is TypeScript's own suggested fix for this class of ambiguity -- add
// another line here if a future operation hits the same shape.
export { GetEventAggregationsParams } from "./generated/api";
// Same collision, this time on two operations' request-body types.
export { CreateUserCategoryBody, SetCategoryColorBody } from "./generated/api";
