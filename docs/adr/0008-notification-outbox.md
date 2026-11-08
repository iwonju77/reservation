# ADR 0008: 알림 outbox와 SMS Provider

- 상태: 개발 기반 완료, 실제 SMS 업체 연동 BLOCKED
- 날짜: 2026-11-08 (Asia/Taipei)

## 결정

예약 트랜잭션은 외부 SMS를 직접 호출하지 않고 outbox 이벤트만 기록한다. worker가 `FOR UPDATE SKIP LOCKED`와 30초 lease로 이벤트를 가져와 활성 언어별 템플릿을 렌더링하고 `NotificationProvider`를 호출한다.

발송 이력은 outbox 이벤트와 채널의 유일키로 중복을 차단하며 업체 메시지 ID, 상태, 시도 수, 오류와 발송·도달 시각을 저장한다. 개발 환경은 실제 네트워크를 사용하지 않는 `FakeNotificationProvider`로 전체 흐름을 검증한다.

## 미확정

실제 SMS 업체, 계정, 발신번호, 공식 서명·콜백 규격과 테스트 수신처가 정해지지 않았다. 따라서 실제 Adapter와 콜백 검증·실발송은 BLOCKED이며 fake 성공을 실발송으로 표시하지 않는다.
