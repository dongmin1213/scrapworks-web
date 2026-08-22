/// <reference types="vite/client" />

// CSS Modules — 클래스 이름은 문자열이다. 이 선언이 없으면 tsc가 모듈을 못 찾는다.
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
