# AWS 시뮬레이터 (aws-sim)

AWS 서비스를 로컬에서 **똑같이 흉내 내어** 연습할 수 있는 학습용 시뮬레이터입니다.
실제 AWS 계정·요금 없이 콘솔 UI, HTTP API, AWS CLI 스타일 명령으로 리소스를 만들고 지우며
자동 채점되는 16개의 실습 미션을 풀 수 있습니다.

- 외부 패키지 없음 — **Node.js 18+ 만 있으면 바로 실행** (Python 3 이 있으면 Python Lambda 런타임도 동작)
- 상태는 `data/state.json` 에 저장되어 서버를 다시 켜도 유지됩니다

## 빠른 시작

```bash
git clone https://github.com/g2jkj0274/aws-sim.git
cd aws-sim
npm start            # http://localhost:4566 에서 콘솔 열림  (npm install 불필요)
```

다른 PC 에서의 설치, 포트 변경, OS 별 주의사항, 문제 해결은 **[docs/SETUP.md](docs/SETUP.md)** 를 보세요.

다른 터미널에서 CLI:

```bash
node cli/awsim.js ec2 describe-images --output table
node cli/awsim.js s3 mb s3://my-first-bucket-2026
node cli/awsim.js labs                 # 실습 진행 상황
npm link && awsim ec2 describe-instances   # 전역 명령으로 쓰고 싶다면
```

| 명령 | 설명 |
|---|---|
| `npm start` | 서버 시작 (포트: `--port=XXXX` 또는 환경변수 `AWSIM_PORT`) |
| `npm run reset` | 모든 리소스를 지우고 시작 |
| `npm test` | 통합 스모크 테스트 (임시 포트에서 51개 시나리오) |
| `npm run test:ui` | 헤드리스 Chrome 으로 콘솔 모달 흐름 23개 클릭 테스트 (서버가 4566 에 떠 있어야 하며 **상태를 초기화**함) |

## 지원 서비스

| 서비스 | 지원 내용 |
|---|---|
| **IAM** | 사용자·그룹·역할·정책(AWS 관리형 13개 내장 + 고객 관리형), 액세스 키, 인라인 정책, **정책 시뮬레이터**(명시적 Deny > Allow > 암시적 Deny), 역할 신뢰 정책 검증 |
| **VPC** | VPC/서브넷(CIDR 포함·겹침 검사)/인터넷 게이트웨이/라우팅 테이블/NAT 게이트웨이, 퍼블릭·프라이빗 서브넷 자동 판정, 리전별 기본 VPC, "VPC 등" 마법사, 리소스 맵 |
| **EC2** | AMI 카탈로그, 인스턴스 유형(가격 포함), 실행/중지/시작/재부팅/종료 상태 전이(pending→running 등), 키 페어(진짜 RSA 키 생성), 보안 그룹 규칙, 탄력적 IP, EBS 볼륨/스냅샷(AZ 일치 검사), 사용자 데이터, 태그, **도달성 검사**(IP·IGW·라우팅·SG 4단계), **시뮬레이션 셸**(메타데이터 curl 등), 콘솔 출력 |
| **S3** | 버킷 이름 규칙 검증, 객체 업로드/다운로드/폴더, 버전 관리와 삭제 마커, 퍼블릭 액세스 차단, 버킷 정책(퍼블릭 읽기 판정), **정적 웹 사이트 호스팅**(`/s3-website/<bucket>/`), 객체 URL(`/s3/<bucket>/<key>`), 이벤트 알림(Lambda/SQS/SNS), 암호화·태그·CORS·수명 주기 |
| **Lambda** | **Node.js 는 실제로 실행**(vm 샌드박스), **Python 은 로컬 python 으로 실행**, 실행 역할 신뢰 검증, 제한 시간/메모리/환경 변수, 테스트 호출 + 로그, 함수 URL, S3·SNS 트리거, SQS 이벤트 소스 매핑(폴링), CloudWatch 로그/지표, 재귀 호출 가드. 함수 안에서 `AWS.S3()` 등(aws-sdk v2 스타일) 또는 Python `boto3` shim 으로 다른 시뮬레이터 서비스 호출 가능 |
| **DynamoDB** | 테이블(파티션/정렬 키, 온디맨드/프로비저닝), DynamoDB JSON ↔ 일반 JSON 자동 변환, PutItem/GetItem/UpdateItem(SET/REMOVE/ADD, 산술, if_not_exists)/DeleteItem/Query/Scan/Batch, **KeyCondition·Filter·Condition 표현식 파서**(=, <, between, begins_with, contains, attribute_exists, AND/OR/NOT …) |
| **SQS** | 표준/FIFO 대기열, 가시성 제한 시간, 지연, 보존 기간, 수신 횟수, **데드 레터 큐 리드라이브**, 퍼지, 큐 미리보기 |
| **SNS** | 주제, SQS/Lambda/이메일/HTTP 구독, 필터 정책, Raw 전송, **이메일 확인 절차를 흉내 낸 받은 편지함**, 팬아웃 전달 결과 |
| **CloudWatch** | EC2/SQS/DynamoDB/Lambda 지표 자동 생성(10초), 사용자 지정 지표, GetMetricStatistics/GetMetricData, **경보**(15초 평가, SNS·EC2 중지 작업), 로그 그룹/스트림/이벤트/필터 |
| **요금** | 실행 시간·볼륨·유휴 EIP·NAT 등 "무엇이 과금되는지" 보여주는 월 요금 추정 |
| **기록** | 모든 변경 작업의 이벤트 기록(CloudTrail 흉내) |

콘솔은 리전 선택기를 제공하며 EC2·VPC·Lambda 등은 리전별로 분리되고, S3·IAM 은 글로벌입니다.

## 실습 미션 (자동 채점)

콘솔의 **🎓 실습** 메뉴 또는 `awsim labs`. 리소스 상태를 보고 5초마다 자동 채점됩니다.

| Lv | 미션 |
|---|---|
| 1 | S3 첫걸음 · IAM 최소 권한 · Lambda 함수 만들고 호출 |
| 2 | S3 정적 웹 사이트 · S3 버전 관리 · IAM 정책 작성 · VPC 구축 · EC2 웹 서버 · DynamoDB CRUD · 비용 정리 |
| 3 | EC2 수명 주기 · S3→Lambda 트리거 · SNS→SQS 팬아웃 · SQS DLQ · SQS→Lambda 매핑 · CloudWatch 경보 |

## CLI 사용법 (AWS CLI 문법)

```
awsim <service> <command> [--option value ...] [--region r] [--output json|table|text]
```

- 명령은 `kebab-case` → API 작업 `PascalCase` 로 변환됩니다 (`run-instances` → `RunInstances`).
- 값은 JSON(`'{...}'`), 짧은 구문(`Key=Name,Value=web`), 파일(`file://x.json`, `fileb://index.js`)을 지원합니다.
- `awsim help <service>` 로 지원 작업을, `--debug` 로 실제 전송 파라미터를 볼 수 있습니다.
- 설정 저장: `awsim configure --region us-east-1 --output table` (→ `~/.awsim/config.json`)

```bash
awsim ec2 run-instances --image-id ami-0c9c942bd7bf113a2 --instance-type t2.micro --security-groups web-sg \
  --user-data "#!/bin/bash\nyum install -y httpd\nsystemctl start httpd"
awsim ec2 authorize-security-group-ingress --group-name web-sg --protocol tcp --port 80 --cidr 0.0.0.0/0
awsim s3api put-bucket-policy --bucket my-site --policy file://policy.json
awsim lambda invoke --function-name hello-lambda --payload '{"name":"AWS"}' out.json
awsim dynamodb query --table-name Orders --key-condition-expression "customerId = :c" \
  --expression-attribute-values '{":c":{"S":"c1"}}'
awsim iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:user/dev-user \
  --action-names s3:GetObject s3:PutObject
awsim logs tail /aws/lambda/hello-lambda
```

## HTTP API

```
POST http://localhost:4566/api/<service>/<Action>     (JSON 본문, 헤더 x-region 선택)
GET  /api/meta        서비스·작업 목록, 리전, 인스턴스 유형
GET  /api/labs        실습 채점 결과
GET  /api/history     이벤트 기록
POST /api/reset       전체 초기화
GET  /s3/<bucket>/<key>          퍼블릭 객체 (버킷 정책·퍼블릭 차단 설정 반영)
GET  /s3-website/<bucket>/       정적 웹 사이트
ANY  /lambda-url/<function>/     Lambda 함수 URL
```

오류는 실제 AWS 처럼 `{"__type": "InvalidSubnet.Conflict", "message": "..."}` 형태와 HTTP 상태 코드로 돌아옵니다.

## 프로젝트 구조

```
server/
  index.js         HTTP 서버, 라우팅, 정적 콘솔 서빙
  registry.js      서비스 디스패처 (서비스 간 호출, 이벤트 기록, 실습 카운터)
  store.js         data/state.json 영속화
  util.js          ID/ARN/CIDR/필터 유틸
  labs.js          실습 미션 정의와 채점 함수
  services/        iam, vpc, ec2, s3, lambda, dynamodb, sqs, sns, cloudwatch, billing
console/           AWS 콘솔을 본뜬 SPA (의존성 없음)
cli/awsim.js       AWS CLI 문법 호환 CLI
test/smoke.js      통합 테스트
```

## 실제 AWS 와 다른 점

- 인증이 없습니다. 모든 호출은 계정 `123456789012` 의 관리자로 간주되며, IAM 정책은 **시뮬레이터로 평가**할 뿐 API 호출을 막지는 않습니다.
- 실제 AWS SDK/CLI 의 XML·Query 프로토콜은 구현하지 않았습니다. (JSON API + 포함된 CLI 를 사용하세요)
- EC2 인스턴스는 실제로 부팅되지 않습니다. 셸·지표·도달성은 학습용 시뮬레이션입니다.
- Lambda Node.js 코드는 `aws-sdk`, `crypto`, `util`, `url`, `path` 만 `require` 할 수 있습니다.
