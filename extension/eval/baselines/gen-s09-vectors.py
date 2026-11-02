# 用原版 s09 代码生成移植校验用的测试向量：python3 gen-s09-vectors.py <learn-claude-code>/s09_memory/code.py <输出目录里的任意文件名> > s09-vectors.json
# anthropic、dotenv、yaml 换成空壳，不读 .env、不发请求
import importlib.util, json, os, sys, types
anthropic = types.ModuleType('anthropic')
class Anthropic:
    def __init__(self, **kwargs): pass
anthropic.Anthropic = Anthropic
dotenv = types.ModuleType('dotenv')
dotenv.load_dotenv = lambda **kwargs: None
yaml = types.ModuleType('yaml')
sys.modules.update(anthropic=anthropic, dotenv=dotenv, yaml=yaml)
os.environ['MODEL_ID'] = 'stub'
os.chdir(os.path.dirname(os.path.abspath(sys.argv[2])))
spec = importlib.util.spec_from_file_location('s09', sys.argv[1])
s09 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s09)

slugs = ['User Preference Tabs', '先给提示再给代码', '  --Hello__World--  ', '二分 边界-老写错', 'C++ 语言', '!!!', '', 'a_b c', 'Mixed中文ABC 123']
base = {'name': 'lang-pref', 'type': 'user', 'scope': 'persistent', 'description': '主要用 Go', 'body': '用户主要用 Go 写题'}
existing = [{'name': 'Lang Pref', 'description': '其他描述', 'body': '其他正文'}, {'name': 'x', 'description': '  同样的   描述 ', 'body': 'y'}, {'name': 'z', 'description': 'w', 'body': 'Same   BODY'}]
candidates = [
    base,
    {**base, 'name': 'other'},
    {**base, 'name': 'other', 'scope': 'current_task'},
    {**base, 'name': 'other', 'type': 'skill'},
    {**base, 'name': ''},
    {**base, 'name': 'other', 'description': ' '},
    {**base, 'name': 'other', 'body': ''},
    {**base, 'name': 'other', 'body': '暂时先用 Go'},
    {**base, 'name': 'other', 'body': 'For now use Go'},
    {**base, 'name': 'other', 'description': '本次任务不要写文件'},
    {**base, 'name': 'other', 'description': '同样的 描述'},
    {**base, 'name': 'other', 'body': 'same body'},
    'not a dict',
]
records = [
    {'filename': 'a.md', 'name': 'binary-search', 'description': '二分查找的边界老写错'},
    {'filename': 'b.md', 'name': 'lang', 'description': 'prefers golang for practice'},
    {'filename': 'c.md', 'name': 'goal', 'description': '目标是字节的秋招'},
    {'filename': 'd.md', 'name': 'hints', 'description': 'hints before code, golang examples'},
]
queries = ['golang 二分查找', 'what about golang practice', '目标', '二分查找的边界老写错', 'ab', '', 'hints code golang']
messages = [
    {'role': 'user', 'content': 'q1'}, {'role': 'assistant', 'content': 'a1'}, {'role': 'user', 'content': '  q2  '},
    {'role': 'assistant', 'content': [{'type': 'text', 'text': 'a2'}, {'type': 'tool_use', 'id': 'x'}]},
    {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'x', 'content': 'out'}]},
    {'role': 'user', 'content': 'q3'}, {'role': 'user', 'content': 'q4'},
]
jsons = ['前缀 [0, 2] 后缀', 'no array', '[1, 2', '{"a": [1]} [3]', '[{"name": "x"}]', '[] [1]', 'x[not json] [4,5]']
out = {
    'slug': [[x, s09.memory_slug(x)] for x in slugs],
    'shouldStore': [[c, s09.should_store_memory(c, existing)] for c in candidates],
    'existing': existing,
    'records': records,
    'keyword': [[q, s09.keyword_memory_selection(records, q, 2)] for q in queries],
    'messages': messages,
    'recentUserText': s09.recent_user_text(messages),
    'recentUserTextOne': s09.recent_user_text(messages, 1),
    'dialogueText': s09.dialogue_text(messages),
    'dialogueTextTwo': s09.dialogue_text(messages, 2),
    'extractJsonArray': [[t, s09.extract_json_array(t)] for t in jsons],
    'validate': [[r, s09.validate_memory_record(r, require_scope=True)] for r in [base, {**base, 'scope': 'x'}, {**base, 'scope': ''}, {**base, 'type': 'x'}, 3, {'name': ' a ', 'type': 'user', 'description': ' d ', 'body': ' b ', 'scope': 'current_task'}]],
    'validateNoScope': [[r, s09.validate_memory_record(r)] for r in [{'name': 'a', 'type': 'user', 'description': 'd', 'body': 'b'}, {'name': 'a', 'type': 'user', 'description': 'd', 'body': 'b', 'scope': 'x'}]],
    'markers': list(s09.TEMPORARY_MEMORY_MARKERS),
}
print(json.dumps(out, ensure_ascii=False, indent=1))
