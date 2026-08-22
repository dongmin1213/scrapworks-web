# 스크랩웍스 웹판 (scrapworks-web)

> 원본(Unity 모바일 세로)을 **TypeScript로 이식**해 ZeroDot에서 바로 플레이되게 한 판본.
> 원본: `../scrapworks` (Unity 6000.3) — **원본은 더 이상 이 레포를 모른다.**

**한 줄 훅**: 뭐가 들었는지는 열어봐야 안다. **부술까, 뜯을까.**

## 왜 재작성인가 (Unity WebGL이 아니라)

| | Unity WebGL | TS 재작성 |
|---|---|---|
| 번들 | 수십 MB (엔진 런타임 포함) | **788K** |
| 첫 화면 | 로딩 진행바 수 초 | 즉시 |
| 예산(2MB/3초) | 불가 | 여유 |

이 게임은 **인크리멘탈**이라 실시간 렌더링이 거의 없다 — 규칙과 UI가 전부다.
그래서 엔진째 들고 오는 대가가 얻는 것보다 훨씬 크다.
(실시간 액션인 조선 퇴마는 판단이 다르다 — 그쪽은 별도 검토)

## 정확성을 어떻게 보장하나

**옮겨 적지 않는다. 대조한다.**

- **수치**: 원본 `balance.json`을 **그대로 복사**해 쓴다 (`engine/content/balance.json`)
- **문자열**: 원본 `Loc.cs`에서 **기계로 추출**한다 (132개, ko/en)
- **난수**: .NET `System.Random`을 재현한다 (`engine/src/rng.ts`) —
  같은 시드에서 같은 수열이 나와야 대조가 성립한다
- **골든**: `golden/harness`가 원본 레포의 `Balance.cs`·`YardLine.cs`·`Workshop.cs`를
  **링크로 컴파일해 그대로 실행**하고, TS가 그 결과와 대조한다 (**234건**).
  수식을 옮겨 적지 않는다 — 옮겨 적으면 같은 실수가 양쪽에 들어가 전부 통과한다.
  `pnpm golden:verify`가 픽스처 최신성을 검사하고, `engine/test/mutation.test.ts`가
  **골든이 정말 결함을 잡는지**를 검사한다.

```bash
pnpm golden   # 원본에서 픽스처 재생성 (dotnet-script 필요)
pnpm test     # TS가 픽스처와 일치하는지
```

## 구조

```
engine/          헤드리스 규칙 — DOM·React를 모른다 (골든이 여기를 돌린다)
  src/balance.ts   수치 로더 + 등급 곡선
  src/rng.ts       .NET System.Random 재현
  src/workshop.ts  영구 상태 + 스탯 집계
  src/yardLine.ts  매입·컨베이어·해체·발견물 (원본 YardLine 1:1)
  content/         balance.json · strings.json (원본에서 온 것)
web/             화면 — 상태를 보여주고 입력만 전달
  src/Stage.tsx    390×844 논리 프레임을 화면에 맞게 스케일
golden/          원본 대조 장치
```

## 이식 범위

**된 것**: 매입 → 컨베이어 → 대기열 → 해체(부수기/뜯기) → 정산 → 발견물 → 등급 해금,
자원 5종, 저장(localStorage), 어떤 화면 비율에서도 잘리지 않는 스테이지.

**아직 아닌 것** (원본에는 있다 — 없는 것을 있는 척하지 않는다):
스킬 노드 트리, 작업자 고용, 인증, 도감 패시브, 보조 작업대, 야간 작업조(오프라인 진행),
경매, 등급 4~10 전용 에셋. 엔진의 `nodeSum`/`codexBonus`가 0을 돌려주므로
수식은 그대로 성립하고, 붙일 때 그 함수만 채우면 된다.

## ZeroDot에 올리기

```bash
pnpm bundle v0.1.0     # 빌드 + tar.gz (빌드를 따로 하면 버전이 어긋난다)
# 어드민(admin.zerodot.app) → 프로젝트 → scrapworks → 빌드 업로드 → 론칭
```
