// hyperswarm / b4a 没有官方 .d.ts，这里声明为 any 以通过 tsc。
declare module 'hyperswarm' {
  const Hyperswarm: any;
  export default Hyperswarm;
}
declare module 'b4a' {
  const b4a: any;
  export default b4a;
}
declare module 'dht-rpc' {
  const DHT: any;
  export default DHT;
}
