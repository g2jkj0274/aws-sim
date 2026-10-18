# 다른 PC에서 설치하고 실행하기

이 문서는 저장소를 처음 받는 PC(Windows / macOS / Linux) 기준으로 설치부터 첫 실습까지 안내합니다.

## 1. 필요한 것

| 항목 | 필수 여부 | 비고 |
|---|---|---|
| **Node.js 18 이상** (20 또는 22 권장) | 필수 | https://nodejs.org 에서 LTS 설치. `node --version` 으로 확인 |
| Git | 권장 | 저장소를 `git clone` 으로 받을 때 필요. ZIP 다운로드로 대체 가능 |
| Python 3.8 이상 | 선택 | Lambda **Python 런타임**을 쓸 때만 필요. 없으면 Node.js 런타임만 동작 |
| Google Chrome | 선택 | `npm run test:ui` (콘솔 클릭 테스트)에만 필요 |

외부 npm 패키지는 사용하지 않으므로 `npm install` 이 필요 없습니다. 인터넷 연결 없이도 실행됩니다.

## 2. 받기

```bash
git clone https://github.com/g2jkj0274/aws-sim.git
cd aws-sim
```

Git 이 없다면 GitHub 저장소 페이지에서 **Code → Download ZIP** 으로 받아 압축을 풀고 그 폴더로 이동합니다.

비공개 저장소라면 먼저 로그인합니다.

```bash
gh auth login          # GitHub CLI 가 있을 때
# 또는 git clone 시 GitHub 사용자 이름 + Personal Access Token 입력
```

## 3. 실행

```bash
npm start
```

```
  AWS 시뮬레이터가 시작되었습니다.
  콘솔:   http://localhost:4566/
```

브라우저에서 http://localhost:4566 을 열면 콘솔이 나타납니다.
서버를 끄려면 터미널에서 `Ctrl + C`.

### 포트 바꾸기

4566 이 이미 사용 중이면 다른 포트로 띄웁니다.

```bash
node server/index.js --port=8080
# 또는
AWSIM_PORT=8080 npm start          # macOS / Linux / Git Bash
set AWSIM_PORT=8080 && npm start   # Windows cmd
$env:AWSIM_PORT=8080; npm start    # Windows PowerShell
```

CLI 도 같은 포트를 보도록 설정합니다.

```bash
node cli/awsim.js configure --endpoint-url http://localhost:8080
```

### 상태 초기화

리소스는 `data/state.json` 에 저장됩니다. 처음부터 다시 하려면:

```bash
npm run reset
```

## 4. CLI 사용

```bash
node cli/awsim.js ec2 describe-images --output table
node cli/awsim.js labs
```

매번 `node cli/awsim.js` 를 치기 번거로우면 전역 명령으로 등록합니다.

```bash
npm link            # macOS/Linux 는 sudo 가 필요할 수 있음
awsim ec2 describe-instances
```

`npm link` 가 싫다면 별칭을 만들어도 됩니다.

```bash
# macOS / Linux / Git Bash  (~/.bashrc 또는 ~/.zshrc)
alias awsim='node /경로/aws-sim/cli/awsim.js'

# Windows PowerShell ($PROFILE 파일)
function awsim { node C:\경로\aws-sim\cli\awsim.js @args }
```

기본 리전과 출력 형식은 한 번만 저장해 두면 됩니다.

```bash
awsim configure --region ap-northeast-2 --output table
```

## 5. 첫 실습

1. 콘솔 왼쪽 메뉴 **🎓 실습 미션** 을 엽니다.
2. **Lv1 · S3 첫걸음** 을 열고 단계를 읽습니다.
3. 콘솔(S3 메뉴)에서 버킷을 만들고 `hello.txt` 를 올리거나, 아래 CLI 를 실행합니다.

```bash
awsim s3 mb s3://my-first-bucket-2026
awsim s3api put-object --bucket my-first-bucket-2026 --key hello.txt --body "안녕하세요"
awsim s3api put-object --bucket my-first-bucket-2026 --key docs/readme.md --body "# docs"
awsim s3 ls s3://my-first-bucket-2026
```

4. 실습 페이지가 5초마다 자동으로 채점되어 ✔ 로 바뀝니다.

## 6. 운영체제별 참고

### Windows
- **PowerShell** 에서 JSON 을 인자로 줄 때는 작은따옴표로 감쌉니다: `--payload '{"name":"AWS"}'`.
- **cmd** 에서는 큰따옴표를 이스케이프해야 합니다: `--payload "{\"name\":\"AWS\"}"`. 복잡한 JSON 은 파일로 저장하고 `--payload file://event.json` 을 쓰는 것이 편합니다.
- **Git Bash** 에서 `#!/bin/bash` 처럼 `/` 로 시작하는 문자열이 Windows 경로로 바뀌는 현상이 있습니다. 사용자 데이터는 콘솔의 템플릿이나 `--user-data file://userdata.sh` 로 넣으세요.
- Python Lambda 는 `python` 명령이 PATH 에 있어야 합니다 (Microsoft Store 버전도 가능).

### macOS / Linux
- `npm link` 시 권한 오류가 나면 `sudo npm link` 또는 위의 alias 방식을 쓰세요.
- Python 명령 이름이 `python3` 뿐이어도 자동으로 찾습니다.

## 7. 여러 PC 에서 진행 상황 이어가기

실습 진행 상황과 리소스는 모두 `data/state.json` 한 파일에 있습니다.
이 파일을 복사하면 다른 PC 에서 그대로 이어서 할 수 있습니다. (저장소에는 커밋되지 않도록 `.gitignore` 에 포함되어 있습니다)

## 8. 문제 해결

| 증상 | 조치 |
|---|---|
| `EADDRINUSE` 포트 사용 중 | 다른 포트로 실행 (`--port=8080`) 또는 이전 서버 종료 |
| CLI 가 "서버에 연결할 수 없습니다" | `npm start` 가 켜져 있는지, 포트/엔드포인트 설정(`awsim configure`)이 맞는지 확인 |
| Lambda Python 호출 시 "Python 이 설치되어 있지 않아…" | Python 3 설치 후 터미널을 다시 열어 `python --version` 확인 |
| 콘솔이 빈 화면 | 브라우저 캐시 새로고침(`Ctrl+Shift+R`). 주소가 `http://localhost:포트/` 인지 확인 |
| 상태가 꼬인 것 같을 때 | `npm run reset` 으로 초기화 |

## 9. 정상 동작 확인

```bash
npm test            # 백엔드 통합 테스트 51개 (임시 포트 사용, 기존 상태에 영향 없음)
npm run test:ui     # 콘솔 클릭 테스트 23개 (서버가 4566 에 떠 있어야 하며 상태를 초기화함)
```
