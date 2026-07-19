아주 큰 도움: chatgpt & claude  

----------------------------------------------------
EXIF VIEWER

__init__.py
py/exif_viewer.py
web/exif_viewer.js

exif viewer v1.0 
nai, comfyui, reforge, forgeneo 지원  
(일부 복잡한 comfyui 워크플로우에선 오류가 날 수 있음)  
(Errors may occur in some complex comfyui workflows)  

exif viewer v1.1 긍정, 부정 프롬프트 출력 지원  
(positive, negative prompt output added)  

사용법: exif가 있는 이미지를 드래그해서 노드에 넣는다.  
------------------------------------------------------
TAG NODE  
  
__init__.py  
py/tag_node.py  
web/tag_node.js  
web/image
web/ko_KR.yaml
  
tag node v1.0  
단어,문장형 지원  
컨트롤+z 실행취소, 컨트롤+y 실행복귀  
구글 번역 지원  
  
주의할점  
노드에서 색깔바꾸는 기능은 실시간 yaml연동이므로 yaml을 수정했다면 저장한다음 써야함  
그룹안에 같은 요소가 있으면 오류  
특수문자는 ""와 ''를 사용 예) "> o": '>_o 표정'  
