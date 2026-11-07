// The registry lives in shared so api, worker and ws expose metrics the same way.
export { Counter, Gauge, Registry, type Labels } from '@traderoom/shared';
